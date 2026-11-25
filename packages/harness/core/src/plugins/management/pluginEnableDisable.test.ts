/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ENV_PLUGIN_CACHE_DIR } from "../../config/brand.js";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  disableAllPluginsOp,
  setPluginEnabledOp,
  type PluginSettingsAccessor,
} from './pluginEnableDisable.js';
import * as installedPluginsManager from './installedPluginsManager.js';
import type { LoadedPlugin } from '../types.js';

function makePlugin(
  name: string,
  source: string,
  dependencies?: string[],
  enabled = true,
): LoadedPlugin {
  return {
    name,
    source,
    path: `/fake/path/${name}`,
    enabled,
    manifest: {
      name,
      version: '1.0.0',
      ...(dependencies ? { dependencies } : {}),
    },
  } as unknown as LoadedPlugin;
}

function createSettings(initial: Record<string, boolean> = {}): {
  accessor: PluginSettingsAccessor;
  record: Record<string, boolean>;
} {
  const record = { ...initial };
  const accessor: PluginSettingsAccessor = {
    getEnabledPlugins: () =>
      Object.entries(record)
        .filter(([, value]) => value === true)
        .map(([id]) => id),
    getDisabledPlugins: () =>
      Object.entries(record)
        .filter(([, value]) => value === false)
        .map(([id]) => id),
    getPluginsSettings: () => ({
      disabled: Object.entries(record)
        .filter(([, value]) => value === false)
        .map(([id]) => id),
    }),
    setPluginEnabled: (_scope, pluginId, enabled) => {
      record[pluginId] = enabled;
      return true;
    },
  };
  return { accessor, record };
}

describe('pluginEnableDisable dependency handling', () => {
  it.each([true, false])(
    'writes arbitrary plugin settings without a product policy when enabled=%s',
    (enabled) => {
      const { accessor, record } = createSettings({
        'host-owned@host-market': !enabled,
      });

      const result = setPluginEnabledOp(
        'host-owned@host-market',
        enabled,
        accessor,
      );

      expect(result.ok).toBe(true);
      expect(record['host-owned@host-market']).toBe(enabled);
    },
  );

  it('enables installed dependencies before enabling a plugin', () => {
    const { accessor, record } = createSettings({ 'dep@mp': false });
    const plugins = [
      makePlugin('consumer', 'mp', ['dep']),
      makePlugin('dep', 'mp', undefined, false),
    ];

    const result = setPluginEnabledOp('consumer@mp', true, accessor, {
      loadedPlugins: plugins,
      scope: 'user',
    });

    expect(result.ok).toBe(true);
    expect(record['dep@mp']).toBe(true);
    expect(record['consumer@mp']).toBe(true);
  });

  it('blocks disabling a plugin with enabled dependents', () => {
    const { accessor, record } = createSettings({
      'consumer@mp': true,
      'dep@mp': true,
    });
    const plugins = [
      makePlugin('consumer', 'mp', ['dep']),
      makePlugin('dep', 'mp'),
    ];

    const result = setPluginEnabledOp('dep@mp', false, accessor, {
      loadedPlugins: plugins,
      scope: 'user',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('consumer@mp');
    }
    expect(record['dep@mp']).toBe(true);
  });

  it('allows bulk disable without dependency-order failures', () => {
    const { accessor, record } = createSettings();
    const plugins = [
      makePlugin('consumer', 'mp', ['dep']),
      makePlugin('dep', 'mp'),
    ];

    const results = disableAllPluginsOp(accessor, { loadedPlugins: plugins });

    expect(results.every((result) => result.ok)).toBe(true);
    expect(record['consumer@mp']).toBe(false);
    expect(record['dep@mp']).toBe(false);
  });
});

describe('pluginEnableDisable enterprise (managed) lock', () => {
  const installationsSpy = vi.spyOn(
    installedPluginsManager,
    'getPluginInstallationsFresh',
  );

  beforeEach(() => {
    installationsSpy.mockReset();
  });

  afterEach(() => {
    installationsSpy.mockReset();
  });

  it('refuses to disable a managed entry with userCanDisable=false', () => {
    const { accessor, record } = createSettings({
      'foo@qoder-enterprise-acme': true,
    });
    installationsSpy.mockReturnValue([
      {
        scope: 'managed',
        installPath: '/tmp/foo/1.0.0',
        version: '1.0.0',
        orgId: 'acme',
        userVisible: true,
        userCanDisable: false,
        fileHash: 'sha256:abc',
        fileSize: 1,
      },
    ]);

    const result = setPluginEnabledOp(
      'foo@qoder-enterprise-acme',
      false,
      accessor,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('is blocked by enterprise policy');
    }
    // Settings record must be untouched
    expect(record['foo@qoder-enterprise-acme']).toBe(true);
  });

  it('allows disabling a managed entry when userCanDisable !== false', () => {
    const { accessor } = createSettings({
      'foo@qoder-enterprise-acme': true,
    });
    installationsSpy.mockReturnValue([
      {
        scope: 'managed',
        installPath: '/tmp/foo/1.0.0',
        version: '1.0.0',
        orgId: 'acme',
        userVisible: true,
        userCanDisable: true,
        fileHash: 'sha256:abc',
        fileSize: 1,
      },
    ]);

    const result = setPluginEnabledOp(
      'foo@qoder-enterprise-acme',
      false,
      accessor,
    );

    expect(result.ok).toBe(true);
  });

  it('does not block enabling (the guard is disable-only)', () => {
    const { accessor } = createSettings({
      'foo@qoder-enterprise-acme': false,
    });
    installationsSpy.mockReturnValue([
      {
        scope: 'managed',
        installPath: '/tmp/foo/1.0.0',
        version: '1.0.0',
        orgId: 'acme',
        userVisible: true,
        userCanDisable: false,
        fileHash: 'sha256:abc',
        fileSize: 1,
      },
    ]);

    const result = setPluginEnabledOp(
      'foo@qoder-enterprise-acme',
      true,
      accessor,
    );

    expect(result.ok).toBe(true);
  });

  it('refuses to disable when userVisible=false even if userCanDisable=true (no UI affordance)', () => {
    const { accessor, record } = createSettings({
      'silent@qoder-enterprise-acme': true,
    });
    installationsSpy.mockReturnValue([
      {
        scope: 'managed',
        installPath: '/tmp/silent/1.0.0',
        version: '1.0.0',
        orgId: 'acme',
        userVisible: false,
        userCanDisable: true,
        fileHash: 'sha256:abc',
        fileSize: 1,
      },
    ]);

    const result = setPluginEnabledOp(
      'silent@qoder-enterprise-acme',
      false,
      accessor,
    );

    expect(result.ok).toBe(false);
    expect(record['silent@qoder-enterprise-acme']).toBe(true);
  });
});

describe('pluginEnableDisable enterprise lock — cross-process visibility', () => {

  const originalCacheDir = process.env[ENV_PLUGIN_CACHE_DIR];
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'enable-disable-'));
    mkdirSync(workspace, { recursive: true });
    process.env[ENV_PLUGIN_CACHE_DIR] = workspace;
    installedPluginsManager.invalidateInstalledPluginsCache();
  });

  afterEach(() => {
    installedPluginsManager.invalidateInstalledPluginsCache();
    if (originalCacheDir === undefined) {
      delete process.env[ENV_PLUGIN_CACHE_DIR];
    } else {
      process.env[ENV_PLUGIN_CACHE_DIR] = originalCacheDir;
    }
    rmSync(workspace, { recursive: true, force: true });
  });

  it('honours a managed lock this process has not cached yet', () => {
    const statePath = join(workspace, 'installed_plugins_v2.json');
    writeFileSync(statePath, JSON.stringify({ version: 2, plugins: {} }));

    // This process warms its cache while the plugin is not managed anywhere.
    expect(
      installedPluginsManager.loadInstalledPluginsFromDisk().plugins,
    ).toEqual({});

    // Enterprise sync in another process pushes an admin-locked entry.
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 2,
        plugins: {
          'foo@qoder-enterprise-acme': [
            {
              scope: 'managed',
              installPath: '/tmp/foo/1.0.0',
              version: '1.0.0',
              orgId: 'acme',
              userVisible: true,
              userCanDisable: false,
            },
          ],
        },
      }),
    );

    const { accessor, record } = createSettings({
      'foo@qoder-enterprise-acme': true,
    });
    const result = setPluginEnabledOp(
      'foo@qoder-enterprise-acme',
      false,
      accessor,
    );

    expect(result.ok).toBe(false);
    expect(record['foo@qoder-enterprise-acme']).toBe(true);
  });
});

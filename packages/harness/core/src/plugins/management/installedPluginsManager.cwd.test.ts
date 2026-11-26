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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  invalidateInstalledPluginsCache,
  isPluginInstalled,
  isPluginInstalledForCwd,
} from './installedPluginsManager.js';



let workspaceRoot: string;
let pluginsDir: string;
const originalCacheDir = process.env[ENV_PLUGIN_CACHE_DIR];

function v2Path(): string {
  return join(pluginsDir, 'installed_plugins_v2.json');
}

function seedV2(plugins: Record<string, unknown[]>): void {
  writeFileSync(v2Path(), JSON.stringify({ version: 2, plugins }));
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'iplugins-cwd-'));
  pluginsDir = workspaceRoot;
  process.env[ENV_PLUGIN_CACHE_DIR] = pluginsDir;
  mkdirSync(pluginsDir, { recursive: true });
  invalidateInstalledPluginsCache();
});

afterEach(() => {
  invalidateInstalledPluginsCache();
  if (originalCacheDir === undefined) {
    delete process.env[ENV_PLUGIN_CACHE_DIR];
  } else {
    process.env[ENV_PLUGIN_CACHE_DIR] = originalCacheDir;
  }
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('isPluginInstalledForCwd', () => {
  it('returns false when the plugin has no installation records at all', () => {
    expect(isPluginInstalledForCwd('worker@jet-skills', '/projectA')).toBe(
      false,
    );
    expect(isPluginInstalled('worker@jet-skills')).toBe(false);
  });

  it('returns true for a user-scope install regardless of cwd', () => {
    seedV2({
      'worker@jet-skills': [
        { scope: 'user', installPath: '/cache/worker', version: '1.0.0' },
      ],
    });
    expect(isPluginInstalledForCwd('worker@jet-skills', '/projectA')).toBe(
      true,
    );
    expect(isPluginInstalledForCwd('worker@jet-skills', '/projectB')).toBe(
      true,
    );
    expect(isPluginInstalled('worker@jet-skills')).toBe(true);
  });

  it('returns true in the installing project and false in another project for a local-scope install', () => {
    seedV2({
      'worker@jet-skills': [
        {
          scope: 'local',
          installPath: '/cache/worker/local',
          version: 'local',
          projectPath: '/projectA',
        },
      ],
    });

    // Global isPluginInstalled sees the record from any cwd — the bug.
    expect(isPluginInstalled('worker@jet-skills')).toBe(true);

    // isPluginInstalledForCwd respects the per-project scope.
    expect(isPluginInstalledForCwd('worker@jet-skills', '/projectA')).toBe(
      true,
    );
    expect(isPluginInstalledForCwd('worker@jet-skills', '/projectB')).toBe(
      false,
    );
  });

  it('returns true when the cwd is a subdirectory of the local-scope projectPath', () => {
    seedV2({
      'worker@jet-skills': [
        {
          scope: 'local',
          installPath: '/cache/worker/local',
          version: 'local',
          projectPath: '/projectA',
        },
      ],
    });
    expect(
      isPluginInstalledForCwd('worker@jet-skills', '/projectA/subdir'),
    ).toBe(true);
  });

  it('returns true when at least one of multiple entries applies to the cwd', () => {
    seedV2({
      'worker@jet-skills': [
        {
          scope: 'local',
          installPath: '/cache/worker/local',
          version: 'local',
          projectPath: '/projectA',
        },
        {
          scope: 'local',
          installPath: '/cache/worker/local',
          version: 'local',
          projectPath: '/projectC',
        },
      ],
    });
    expect(isPluginInstalledForCwd('worker@jet-skills', '/projectA')).toBe(
      true,
    );
    expect(isPluginInstalledForCwd('worker@jet-skills', '/projectC')).toBe(
      true,
    );
    expect(isPluginInstalledForCwd('worker@jet-skills', '/projectB')).toBe(
      false,
    );
  });

  it('returns true for a project-scope install in the matching project, false in others', () => {
    seedV2({
      'worker@jet-skills': [
        {
          scope: 'project',
          installPath: '/cache/worker/project',
          version: '1.0.0',
          projectPath: '/projectA',
        },
      ],
    });
    expect(isPluginInstalledForCwd('worker@jet-skills', '/projectA')).toBe(
      true,
    );
    expect(isPluginInstalledForCwd('worker@jet-skills', '/projectB')).toBe(
      false,
    );
  });
});

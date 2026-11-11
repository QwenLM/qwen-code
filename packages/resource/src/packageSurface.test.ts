/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as resources from './index.js';

const publicApiContract = JSON.parse(
  readFileSync(new URL('../public-api.json', import.meta.url), 'utf8'),
) as { runtimeExports: string[] };

/**
 * The package exposes a single entry point on purpose: modules behind it own
 * process-wide mutable state (Skill load errors, the checked-dir cache, the
 * internal-write table), and every extra entry — or a copy reachable through
 * dist — would carry its own.
 */
describe('public package surface', () => {
  it('declares exactly one entry point', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, unknown> };

    expect(Object.keys(packageJson.exports)).toEqual(['.']);
  });

  it('exposes the agreed runtime exports and nothing more', () => {
    expect(Object.keys(resources).sort()).toEqual(
      publicApiContract.runtimeExports,
    );
  });

  it('exposes shared Hook configuration provenance for both loaders', () => {
    expect(resources.originalHookSettingsPath).toBeTypeOf('function');
    expect(resources.rememberHookArrayRemoval).toBeTypeOf('function');
  });

  it('keeps resource internals out of the published surface', () => {
    for (const name of [
      'SkillResource',
      'AgentResource',
      'OutputStyleResource',
      'OutputStyleProvider',
      'OutputStyleView',
      'ResourceManager',
      'ResourceWatchBridge',
      'SettingsSourceStore',
      'SkillProvider',
      'UserSkillProvider',
      'ProjectSkillProvider',
      'AgentProvider',
      'UserAgentProvider',
      'ProjectAgentProvider',
      'loadSkillDirectorySet',
      'loadAgentDirectory',
      'matchWatchTarget',
      'ChokidarBackendPool',
      'NativeSignalBackend',
      'shouldUseNativeSignals',
      'isInsideBun',
    ]) {
      expect(resources).not.toHaveProperty(name);
    }
  });

  it('exposes settings lifecycle only through SettingsService', async () => {
    const service = new resources.ResourceService();
    const user = new resources.UserResource({ homeDir: process.cwd() });
    try {
      expect(service).not.toHaveProperty('settings');
      expect(user).not.toHaveProperty('settings');
      for (const name of [
        'getUserSettingsSource',
        'getCompatibleUserSettingsSource',
        'peekUserSettingsSource',
        'getProjectSettingsSources',
      ]) {
        expect(service).not.toHaveProperty(name);
        expect(resources.SettingsService.prototype).toHaveProperty(name);
        expect(resources.ProjectResource.prototype).not.toHaveProperty(name);
      }
    } finally {
      await user.dispose();
      await service.dispose();
    }
  });

  it('keeps the old watcher constructor as an alias of the backend-neutral implementation', async () => {
    expect(resources.ChokidarFileWatcher).toBe(resources.FileSystemWatcher);
    const watcher = resources.createFileWatcher();
    try {
      expect(watcher).toBeInstanceOf(resources.FileSystemWatcher);
      expect(watcher).toBeInstanceOf(resources.ChokidarFileWatcher);
    } finally {
      await watcher.stop();
    }
  });
});

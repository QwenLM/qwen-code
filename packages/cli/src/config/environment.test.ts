/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildRuntimeEnvironment } from './environment.js';
import type { Settings } from './settingsSchema.js';

const TRACKED_ENV = [
  'CLOUD_SHELL',
  'GOOGLE_CLOUD_PROJECT',
  'RUNTIME_DOTENV',
  'RUNTIME_EMPTY',
  'RUNTIME_EXCLUDED',
  'RUNTIME_PARENT',
  'RUNTIME_SETTINGS',
  'RUNTIME_SETTINGS_ONLY',
  'QWEN_HOME',
  'QWEN_RUNTIME_DIR',
] as const;

let tmpDirs: string[] = [];
const previousEnv = new Map<string, string | undefined>();

function makeWorkspace(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-runtime-env-')),
  );
  tmpDirs.push(dir);
  return dir;
}

function testSettings(partial: Partial<Settings>): Settings {
  return partial as Settings;
}

beforeEach(() => {
  previousEnv.clear();
  for (const key of TRACKED_ENV) {
    previousEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of TRACKED_ENV) {
    const value = previousEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe('buildRuntimeEnvironment', () => {
  it('computes a runtime overlay without mutating process.env or base env', () => {
    const workspace = makeWorkspace();
    fs.writeFileSync(
      path.join(workspace, '.env'),
      [
        'RUNTIME_DOTENV=from-dotenv',
        'RUNTIME_PARENT=dotenv-loses',
        'RUNTIME_EMPTY=from-dotenv-empty',
        'RUNTIME_SETTINGS=dotenv-wins',
        'RUNTIME_EXCLUDED=excluded',
        'QWEN_HOME=/tmp/ignored-qwen-home',
        '',
      ].join('\n'),
    );
    const baseEnv: NodeJS.ProcessEnv = {
      RUNTIME_PARENT: 'from-parent',
      RUNTIME_EMPTY: '',
    };

    const snapshot = buildRuntimeEnvironment(
      testSettings({
        advanced: {
          excludedEnvVars: ['RUNTIME_EXCLUDED', 'RUNTIME_SETTINGS_EXCLUDED'],
        },
        env: {
          RUNTIME_SETTINGS: 'settings-loses',
          RUNTIME_SETTINGS_ONLY: 'from-settings',
          RUNTIME_SETTINGS_EXCLUDED: 'settings-excluded',
          QWEN_RUNTIME_DIR: '/tmp/ignored-runtime-dir',
        },
      }),
      workspace,
      baseEnv,
    );

    expect(snapshot.effectiveEnv['RUNTIME_DOTENV']).toBe('from-dotenv');
    expect(snapshot.effectiveEnv['RUNTIME_PARENT']).toBe('from-parent');
    expect(snapshot.effectiveEnv['RUNTIME_EMPTY']).toBe('from-dotenv-empty');
    expect(snapshot.effectiveEnv['RUNTIME_SETTINGS']).toBe('dotenv-wins');
    expect(snapshot.effectiveEnv['RUNTIME_SETTINGS_ONLY']).toBe(
      'from-settings',
    );
    expect(snapshot.effectiveEnv['RUNTIME_EXCLUDED']).toBeUndefined();
    expect(snapshot.effectiveEnv['RUNTIME_SETTINGS_EXCLUDED']).toBeUndefined();
    expect(snapshot.effectiveEnv['QWEN_HOME']).toBeUndefined();
    expect(snapshot.effectiveEnv['QWEN_RUNTIME_DIR']).toBeUndefined();
    expect(snapshot.overlayKeys).toEqual([
      'RUNTIME_DOTENV',
      'RUNTIME_EMPTY',
      'RUNTIME_SETTINGS',
      'RUNTIME_SETTINGS_ONLY',
    ]);
    expect(snapshot.envFilePaths).toContain(path.join(workspace, '.env'));

    expect(baseEnv).toEqual({
      RUNTIME_PARENT: 'from-parent',
      RUNTIME_EMPTY: '',
    });
    expect(process.env['RUNTIME_DOTENV']).toBeUndefined();
    expect(process.env['RUNTIME_SETTINGS_ONLY']).toBeUndefined();
  });

  it('applies Cloud Shell project defaults to the runtime env only', () => {
    const workspace = makeWorkspace();
    const snapshot = buildRuntimeEnvironment(testSettings({}), workspace, {
      CLOUD_SHELL: 'true',
    });

    expect(snapshot.effectiveEnv['GOOGLE_CLOUD_PROJECT']).toBe(
      'cloudshell-gca',
    );
    expect(snapshot.overlayKeys).toContain('GOOGLE_CLOUD_PROJECT');
    expect(process.env['GOOGLE_CLOUD_PROJECT']).toBeUndefined();
  });
});

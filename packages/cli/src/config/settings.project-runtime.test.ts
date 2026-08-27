/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FatalConfigError, Storage } from '@qwen-code/qwen-code-core';
import {
  LoadedSettings,
  loadSettings,
  resetHomeEnvBootstrapForTesting,
  type SettingsFile,
} from './settings.js';

function settingsFile(
  filePath: string,
  settings: SettingsFile['settings'],
): SettingsFile {
  return {
    path: filePath,
    settings,
    originalSettings: structuredClone(settings),
    rawJson: JSON.stringify(settings),
  };
}

describe('project runtime settings', () => {
  let tempDir: string;
  let previousQwenHome: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-project-runtime-'));
    previousQwenHome = process.env['QWEN_HOME'];
    process.env['QWEN_HOME'] = path.join(tempDir, 'home');
    resetHomeEnvBootstrapForTesting();
  });

  afterEach(() => {
    if (previousQwenHome === undefined) {
      delete process.env['QWEN_HOME'];
    } else {
      process.env['QWEN_HOME'] = previousQwenHome;
    }
    resetHomeEnvBootstrapForTesting();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects invalid target settings without modifying the file', () => {
    const workspace = path.join(tempDir, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const settingsPath = new Storage(workspace).getWorkspaceSettingsPath();
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{ invalid');

    expect(() =>
      loadSettings(workspace, {
        consumeCorruptionEnvVars: false,
        readOnly: true,
        skipLoadEnvironment: true,
        workspaceTrusted: true,
      }),
    ).toThrow(FatalConfigError);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{ invalid');
    expect(fs.existsSync(`${settingsPath}.corrupted`)).toBe(false);
  });

  it('replaces workspace state without changing the LoadedSettings identity', () => {
    const current = new LoadedSettings(
      settingsFile('/system', {}),
      settingsFile('/defaults', {}),
      settingsFile('/user', { general: { language: 'en' } }),
      settingsFile('/project-a', { disableAllHooks: true }),
      true,
      new Set(),
    );
    const next = new LoadedSettings(
      settingsFile('/system', {}),
      settingsFile('/defaults', {}),
      settingsFile('/user', { general: { language: 'en' } }),
      settingsFile('/project-b', { disableAllHooks: false }),
      true,
      new Set(),
    );

    const previous = current.replaceWith(next);

    expect(current.workspace.path).toBe('/project-b');
    expect(current.merged.disableAllHooks).toBe(false);
    current.replaceWith(previous);
    expect(current.workspace.path).toBe('/project-a');
    expect(current.merged.disableAllHooks).toBe(true);
  });
});

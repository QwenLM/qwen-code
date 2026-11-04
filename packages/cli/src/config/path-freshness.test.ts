/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { getUserSettingsDir, getUserSettingsPath } from './settings.js';
import { getTrustedFoldersPath } from './trustedFolders.js';
import { getGlobalQwenDirLite } from './storage-paths-lite.js';

// Regression guard: `QWEN_HOME` is resolved by `preResolveHomeEnvOverrides()`
// AFTER any module that imports a settings/trustedFolders path has loaded.
// A top-level `const` would freeze the pre-bootstrap value and split state
// across callers. Each test mutates `process.env.QWEN_HOME` post-load and
// asserts the exported path getters reflect the new value.

describe('settings/trustedFolders path getters are lazy', () => {
  let originalQwenHome: string | undefined;
  let originalTrustedPath: string | undefined;

  beforeEach(() => {
    originalQwenHome = process.env['QWEN_HOME'];
    originalTrustedPath = process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'];
    delete process.env['QWEN_HOME'];
    delete process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'];
  });

  afterEach(() => {
    if (originalQwenHome === undefined) delete process.env['QWEN_HOME'];
    else process.env['QWEN_HOME'] = originalQwenHome;
    if (originalTrustedPath === undefined)
      delete process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'];
    else process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'] = originalTrustedPath;
  });

  it('getUserSettingsPath() reflects QWEN_HOME set after module load', () => {
    const defaultPath = getUserSettingsPath();
    expect(defaultPath).toBe(
      path.join(getGlobalQwenDirLite(), 'settings.json'),
    );

    process.env['QWEN_HOME'] = '/tmp/qwen-lazy-test';
    expect(getUserSettingsPath()).toBe(
      path.join('/tmp/qwen-lazy-test', 'settings.json'),
    );
  });

  it('getUserSettingsDir() reflects QWEN_HOME set after module load', () => {
    expect(getUserSettingsDir()).toBe(getGlobalQwenDirLite());

    process.env['QWEN_HOME'] = '/tmp/qwen-lazy-test';
    expect(getUserSettingsDir()).toBe(path.normalize('/tmp/qwen-lazy-test'));
  });

  it('getTrustedFoldersPath() reflects QWEN_HOME set after module load', () => {
    expect(getTrustedFoldersPath()).toBe(
      path.join(getGlobalQwenDirLite(), 'trustedFolders.json'),
    );

    process.env['QWEN_HOME'] = '/tmp/qwen-lazy-test';
    expect(getTrustedFoldersPath()).toBe(
      path.join('/tmp/qwen-lazy-test', 'trustedFolders.json'),
    );
  });
});

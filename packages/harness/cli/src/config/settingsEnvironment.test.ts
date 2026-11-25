/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_DIR } from '@qwen-code/core';
import { loadEnvironment, restoreLoadedEnvironment } from './settings.js';

describe('project environment replacement', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-project-env-'));
    for (const key of [
      'RESUME_ENV_VALUE',
      'RESUME_ENV_OLD_ONLY',
      'RESUME_ENV_HOST',
    ]) {
      vi.stubEnv(key, undefined);
    }
  });
  afterEach(async () => {
    restoreLoadedEnvironment();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function loadProject(name: string, contents: string) {
    const cwd = path.join(root, name);
    await fs.mkdir(path.join(cwd, CONFIG_DIR), { recursive: true });
    await fs.writeFile(path.join(cwd, CONFIG_DIR, '.env'), contents);
    loadEnvironment({}, cwd, () => ({ isTrusted: true, source: undefined }));
  }

  it('replaces injected project values and removes old-only keys without overwriting the host', async () => {
    vi.stubEnv('RESUME_ENV_HOST', 'host');
    await loadProject(
      'a',
      'RESUME_ENV_VALUE=a\nRESUME_ENV_OLD_ONLY=old\nRESUME_ENV_HOST=project-a',
    );
    restoreLoadedEnvironment();
    await loadProject('b', 'RESUME_ENV_VALUE=b\nRESUME_ENV_HOST=project-b');
    expect(process.env['RESUME_ENV_VALUE']).toBe('b');
    expect(process.env['RESUME_ENV_OLD_ONLY']).toBeUndefined();
    expect(process.env['RESUME_ENV_HOST']).toBe('host');
  });

  it('preserves a value changed by another runtime owner after injection', async () => {
    await loadProject('a', 'RESUME_ENV_VALUE=a');
    process.env['RESUME_ENV_VALUE'] = 'external-update';
    restoreLoadedEnvironment();
    await loadProject('b', 'RESUME_ENV_VALUE=b');
    expect(process.env['RESUME_ENV_VALUE']).toBe('external-update');
  });

  it.each([undefined, 'host-project'])(
    'treats Cloud Shell variables as ordinary environment variables (host project: %s)',
    async (hostProject) => {
      vi.stubEnv('CLOUD_SHELL', 'true');
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', hostProject);
      await loadProject('a', 'RESUME_ENV_VALUE=a');
      expect(process.env['GOOGLE_CLOUD_PROJECT']).toBe(hostProject);
      restoreLoadedEnvironment();
      await loadProject('b', 'GOOGLE_CLOUD_PROJECT=project-b');
      expect(process.env['GOOGLE_CLOUD_PROJECT']).toBe(hostProject ?? 'project-b');
      restoreLoadedEnvironment();
      expect(process.env['GOOGLE_CLOUD_PROJECT']).toBe(hostProject);
    },
  );
});

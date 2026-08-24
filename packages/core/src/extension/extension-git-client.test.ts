/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { simpleGit } from 'simple-git';
import { createExtensionGitClient } from './extension-git-client.js';

describe('createExtensionGitClient', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-git-client-'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('runs authenticated Git commands with pinned network config', async () => {
    let spawned = false;
    const git = createExtensionGitClient(simpleGit, {
      baseDir: tempDir,
      networkPolicy: 'public',
      networkConfig: [
        'http.curloptResolve=git.example.com:443:8.8.8.8',
        'http.followRedirects=false',
        'http.proxy=',
        'protocol.allow=never',
        'protocol.https.allow=always',
      ],
      authentication: {
        source: 'https://git.example.com/owner/repo.git',
        credential: { username: 'user', password: 'token' },
      },
    });
    git.outputHandler(() => {
      spawned = true;
    });

    await expect(git.version()).resolves.toBeDefined();
    expect(spawned).toBe(true);
  });

  it('runs authenticated Git commands without pinned network config', async () => {
    let spawned = false;
    const git = createExtensionGitClient(simpleGit, {
      baseDir: tempDir,
      authentication: {
        source: 'https://git.example.com/owner/repo.git',
        credential: { username: 'user', password: 'token' },
      },
    });
    git.outputHandler(() => {
      spawned = true;
    });

    await expect(git.version()).resolves.toBeDefined();
    expect(spawned).toBe(true);
  });

  it('does not inherit Git config count for anonymous public commands', async () => {
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'http.extraHeader');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'Authorization: Basic external');
    let spawned = false;
    const git = createExtensionGitClient(simpleGit, {
      baseDir: tempDir,
      networkPolicy: 'public',
    });
    git.outputHandler(() => {
      spawned = true;
    });

    await expect(git.version()).resolves.toBeDefined();
    expect(spawned).toBe(true);
  });
});

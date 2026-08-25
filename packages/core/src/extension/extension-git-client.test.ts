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
import type { SimpleGit, SimpleGitFactory, SimpleGitOptions } from 'simple-git';
import { createExtensionGitClient } from './extension-git-client.js';

const realSimpleGit = ((
  baseDir: string,
  options?: Partial<SimpleGitOptions>,
) => {
  const binary = process.env['QWEN_CI_REAL_GIT'];
  return simpleGit(baseDir, binary ? { ...options, binary } : options);
}) as SimpleGitFactory;

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
    const git = createExtensionGitClient(realSimpleGit, {
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
    const git = createExtensionGitClient(realSimpleGit, {
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

  it.each([
    'http://git.example.com/owner/repo.git',
    '--upload-pack=attacker-command',
    'https://github.com\\@attacker.example/repo.git',
    'https://user:pass@git.example.com/owner/repo.git',
    'https://git.example.com/owner/repo.git\n',
  ])('rejects unsafe credentialed Git source %s', (source) => {
    expect(() =>
      createExtensionGitClient(realSimpleGit, {
        baseDir: tempDir,
        authentication: {
          source,
          credential: { username: 'user', password: 'token' },
        },
      }),
    ).toThrow(
      'Credentialed Git operations require a valid HTTPS repository URL.',
    );
  });

  it.each([
    ['alias', 'https://github.com/owner/alias-service.git'],
    [
      'credential helper',
      'https://git.example.com/owner/credential.helper.git',
    ],
  ])(
    'runs authenticated Git commands when the URL contains %s text',
    async (_label, source) => {
      let spawned = false;
      const git = createExtensionGitClient(realSimpleGit, {
        baseDir: tempDir,
        authentication: {
          source,
          credential: { username: 'user', password: 'token' },
        },
      });
      git.outputHandler(() => {
        spawned = true;
      });

      await expect(git.version()).resolves.toBeDefined();
      expect(spawned).toBe(true);
    },
  );

  it('does not allow unrelated unsafe config for a URL false positive', async () => {
    let spawned = false;
    const git = createExtensionGitClient(realSimpleGit, {
      baseDir: tempDir,
      authentication: {
        source: 'https://github.com/owner/alias-service.git',
        credential: { username: 'user', password: 'token' },
      },
    });
    git.outputHandler(() => {
      spawned = true;
    });

    await expect(
      git.raw(['-c', 'credential.helper=store', '--version']),
    ).rejects.toThrow('allowUnsafeCredentialHelper');
    expect(spawned).toBe(false);
  });

  it('does not inherit Git config count for anonymous public commands', async () => {
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'http.extraHeader');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'Authorization: Basic external');
    let spawned = false;
    const git = createExtensionGitClient(realSimpleGit, {
      baseDir: tempDir,
      networkPolicy: 'public',
    });
    git.outputHandler(() => {
      spawned = true;
    });

    await expect(git.version()).resolves.toBeDefined();
    expect(spawned).toBe(true);
  });

  it('does not inherit ambient secrets into restricted environments', () => {
    vi.stubEnv('GITHUB_TOKEN', 'ambient-github-token');
    vi.stubEnv('gh_token', 'ambient-gh-token');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'ambient-aws-secret');
    const environments: Array<Record<string, string>> = [];
    const fakeGit = {
      env: (environment: Record<string, string>) => {
        environments.push(environment);
        return fakeGit;
      },
    } as unknown as SimpleGit;
    const factory = (() => fakeGit) as unknown as SimpleGitFactory;

    createExtensionGitClient(factory, {
      baseDir: tempDir,
      networkPolicy: 'public',
    });
    createExtensionGitClient(factory, {
      baseDir: tempDir,
      authentication: {
        source: 'https://git.example.com/owner/repo.git',
        credential: { username: 'user', password: 'token' },
      },
    });

    expect(environments).toHaveLength(2);
    for (const environment of environments) {
      expect(environment).not.toHaveProperty('GITHUB_TOKEN');
      expect(environment).not.toHaveProperty('gh_token');
      expect(environment).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
      expect(environment).toHaveProperty('GIT_CONFIG_NOSYSTEM', '1');
    }
    expect(environments[1]).toHaveProperty(
      'GIT_CONFIG_KEY_0',
      'http.https://git.example.com/owner/repo.git.extraHeader',
    );
  });
});

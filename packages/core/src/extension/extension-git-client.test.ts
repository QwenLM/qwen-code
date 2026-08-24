/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { simpleGit } from 'simple-git';
import type { SimpleGit, SimpleGitFactory, SimpleGitOptions } from 'simple-git';
import { vulnerabilityCheck } from '@simple-git/argv-parser';
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

  it.each([
    'http://git.example.com/owner/repo.git',
    '--upload-pack=attacker-command',
    'https://github.com\\@attacker.example/repo.git',
    'https://user:pass@git.example.com/owner/repo.git',
    'https://git.example.com/owner/repo.git\n',
  ])('rejects unsafe credentialed Git source %s', (source) => {
    expect(() =>
      createExtensionGitClient(simpleGit, {
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
      const git = createExtensionGitClient(simpleGit, {
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
    const git = createExtensionGitClient(simpleGit, {
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

  it('does not inherit ambient GitHub tokens into restricted environments', () => {
    vi.stubEnv('GITHUB_TOKEN', 'ambient-github-token');
    vi.stubEnv('gh_token', 'ambient-gh-token');
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
      expect(environment).toHaveProperty('GIT_CONFIG_NOSYSTEM', '1');
    }
    expect(environments[1]).toHaveProperty(
      'GIT_CONFIG_KEY_0',
      'http.https://git.example.com/owner/repo.git.extraHeader',
    );
  });

  it.each([
    'alias',
    'core.askpass',
    'core.editor',
    'core.fsmonitor',
    'core.gitproxy',
    'core.hookspath',
    'core.pager',
    'core.sshcommand',
    'credential.helper',
    'credential-x.helper',
    'diff.command',
    'diff.external',
    'diff.textconv',
    'filter.clean',
    'filter.smudge',
    'gpg.program',
    'init.templatedir',
    'merge.driver',
    'mergetool.path',
    'mergetool.cmd',
    'protocol.allow',
    'remote.receivepack',
    'remote.uploadpack',
    'remote-x.uploadpack',
    'sequence.editor',
    'owner/repo',
  ])(
    'enables the same unsafe categories for %s sources as the installed parser',
    (fragment) => {
      const source = `https://parity.example/${fragment}`;
      let captured: Partial<SimpleGitOptions> | undefined;
      const fakeGit = {
        env: () => fakeGit,
      } as unknown as SimpleGit;
      const factory = ((
        _baseDir: string,
        options?: Partial<SimpleGitOptions>,
      ) => {
        captured = options;
        return fakeGit;
      }) as unknown as SimpleGitFactory;

      createExtensionGitClient(factory, {
        baseDir: tempDir,
        authentication: {
          source,
          credential: { username: 'user', password: 'token' },
        },
      });

      const unsafe: Record<string, boolean | undefined> = {
        ...captured?.unsafe,
      };
      // Categories set unconditionally for credentialed clients are not part
      // of the mirrored config-key blocklist table.
      delete unsafe['allowUnsafeConfigPaths'];
      delete unsafe['allowUnsafeConfigEnvCount'];
      const enabledCategories = Object.keys(unsafe)
        .filter((key) => unsafe[key])
        .sort();
      const parserCategories = vulnerabilityCheck(
        ['-c', `http.${source}.extraHeader=parity`],
        {},
      )
        .map((vulnerability) => vulnerability.category)
        .sort();

      expect(enabledCategories).toEqual(parserCategories);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'runs restricted Git commands through a PATH wrapper needing a non-allowlisted variable',
    async () => {
      const realGit = execSync('command -v git', { encoding: 'utf8' })
        .trim()
        .split(/\r?\n/)[0];
      expect(realGit).toBeTruthy();
      const wrapperDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'extension-git-wrapper-'),
      );
      await fs.writeFile(
        path.join(wrapperDir, 'git'),
        [
          '#!/bin/sh',
          'if [ -z "$QC_WRAPPER_REAL_GIT" ]; then',
          '  echo "QC_WRAPPER_REAL_GIT missing" >&2',
          '  exit 127',
          'fi',
          'exec "$QC_WRAPPER_REAL_GIT" "$@"',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      vi.stubEnv(
        'PATH',
        `${wrapperDir}${path.delimiter}${process.env['PATH'] ?? ''}`,
      );
      vi.stubEnv('QC_WRAPPER_REAL_GIT', realGit);
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
    },
  );
});

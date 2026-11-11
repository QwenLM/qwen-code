/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { internalGitArgs, internalGitEnv } from './gitCommandPolicy.js';
import { execPluginGit } from '../plugins/pluginGit.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearSystemContext,
  getSystemContext,
} from '../context/system-context.js';
import { listGitFiles } from './filesearch/gitFileList.js';

describe('internal Git fsmonitor isolation', () => {
  let root: string;

  afterEach(async () => {
    clearSystemContext('fsmonitor-regression');
    vi.unstubAllEnvs();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it.each(['local', 'include', 'worktree'])(
    'does not execute a helper from %s configuration',
    async (source) => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), 'test-fsmonitor-'));
      const repo = path.join(root, 'repo');
      await fs.mkdir(repo);
      // Keep the fixture independent of the developer's Git environment.
      const env = {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: path.join(root, 'empty-config'),
      };
      const git = (args: string[]) =>
        execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' });
      git(['init', '-q']);
      await fs.writeFile(path.join(repo, 'tracked.txt'), 'before\n');
      git(['-c', 'core.fsmonitor=false', 'add', 'tracked.txt']);
      const marker = path.join(repo, 'fsmonitor-ran');
      const helper = path.join(repo, 'monitor');
      await fs.writeFile(
        helper,
        '#!/bin/sh\nprintf executed > fsmonitor-ran\nprintf "token\\000"\n',
        { mode: 0o755 },
      );
      if (source === 'include') {
        const config = path.join(root, 'included-config');
        git(['config', '--file', config, 'core.fsmonitor', helper]);
        git(['config', 'include.path', config]);
      } else if (source === 'worktree') {
        git(['config', 'extensions.worktreeConfig', 'true']);
        git(['config', '--worktree', 'core.fsmonitor', helper]);
      } else {
        git(['config', 'core.fsmonitor', helper]);
      }
      // Positive control: prove this fixture would execute the helper.
      git(['status', '--short']);
      expect(await fs.readFile(marker, 'utf8')).toBe('executed');
      await fs.unlink(marker);
      await fs.writeFile(path.join(repo, 'tracked.txt'), 'after\n');

      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
      vi.stubEnv('GIT_CONFIG_GLOBAL', env.GIT_CONFIG_GLOBAL);
      const context = await getSystemContext('fsmonitor-regression', repo);
      expect(context['gitStatus']).toContain('tracked.txt');
      expect(
        await listGitFiles({ cwd: repo, args: ['--cached'], timeoutMs: 5000 }),
      ).toContain('tracked.txt');
      await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      // The override is per command, not a persistent repository mutation.
      expect(git(['config', '--get', 'core.fsmonitor']).trim()).toBe(helper);
    },
  );
});

// Filters are intentionally not executed by automatic context collection.
// This preflight is not a sandbox and does not guard later user Git commands.
describe('automatic Git status filter preflight', () => {
  let root: string;
  afterEach(async () => {
    clearSystemContext('filter-regression');
    vi.unstubAllEnvs();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it.each(
    ['local', 'include', 'worktree', 'global'].flatMap((source) =>
      ['clean', 'process'].map((kind) => ({ source, kind })),
    ),
  )(
    'skips $kind from $source but retains branch context',
    async ({ source, kind }) => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), 'test-filter-'));
      const repo = path.join(root, 'repo space 中文');
      await fs.mkdir(repo);
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
      vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(root, 'global-config'));
      const git = (args: string[]) =>
        execFileSync('git', ['-C', repo, ...args], {
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      git(['init', '-q']);
      await fs.writeFile(path.join(repo, 'tracked.txt'), 'before\n');
      await fs.writeFile(
        path.join(repo, '.gitattributes'),
        '*.txt filter=review\n',
      );
      git(['add', '.']);
      git([
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-qm',
        'fixture',
      ]);
      const branch = git(['branch', '--show-current']).trim();
      const marker = path.join(repo, 'filter-ran');
      await fs.writeFile(
        path.join(repo, 'filter-helper'),
        '#!/bin/sh\nprintf ran > filter-ran\n' +
          (kind === 'clean' ? 'cat\n' : 'exit 1\n'),
        { mode: 0o755 },
      );
      const key = `filter.review.${kind}`;
      if (source === 'include') {
        const included = path.join(root, 'included');
        git(['config', '--file', included, key, './filter-helper']);
        git(['config', 'include.path', included]);
      } else if (source === 'worktree') {
        git(['config', 'extensions.worktreeConfig', 'true']);
        git(['config', '--worktree', key, './filter-helper']);
      } else {
        git([
          'config',
          source === 'global' ? '--global' : '--local',
          key,
          './filter-helper',
        ]);
      }
      // Same-size modification forces content comparison instead of a size shortcut.
      await fs.writeFile(path.join(repo, 'tracked.txt'), 'after!\n');
      await fs.utimes(
        path.join(repo, 'tracked.txt'),
        new Date(),
        new Date(Date.now() + 3000),
      );
      try {
        git(['-c', 'core.fsmonitor=false', 'status', '--short']);
      } catch {
        // The deliberately invalid process protocol exits after writing the marker.
      }
      expect(await fs.readFile(marker, 'utf8')).toBe('ran');
      await fs.unlink(marker);

      const context = await getSystemContext('filter-regression', repo);
      expect(context['gitStatus']).toContain(`Current branch: ${branch}`);
      expect(context['gitStatus']).toContain(
        'not collected: Git content filters are configured',
      );
      expect(context['gitStatus']).not.toContain('(clean)');
      await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(git(['config', '--get', key]).trim()).toBe('./filter-helper');
    },
  );
});

describe('internal Git command policy', () => {
  let root: string;
  afterEach(async () => {
    vi.unstubAllEnvs();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it('blocks ext despite repository opt-in, preserving https/ssh configuration', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'test-git-policy-'));
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(root, 'empty'));
    const git = (args: string[]) =>
      execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
    git(['init', '-q']);
    git(['config', 'protocol.ext.allow', 'always']);
    for (const protocol of ['https', 'ssh']) {
      git(['config', `protocol.${protocol}.allow`, 'always']);
      expect(
        git([
          ...internalGitArgs(),
          'config',
          '--get',
          `protocol.${protocol}.allow`,
        ]).trim(),
      ).toBe('always');
    }
    const helper = path.join(root, 'ext-helper');
    const marker = path.join(root, 'ext-ran');
    await fs.writeFile(helper, '#!/bin/sh\nprintf ran > ext-ran\nexit 1\n', {
      mode: 0o755,
    });
    try {
      git(['ls-remote', `ext::${helper}`]);
    } catch {
      /* No Git protocol server is needed. */
    }
    expect(await fs.readFile(marker, 'utf8')).toBe('ran');
    await fs.unlink(marker);
    expect(() =>
      git([...internalGitArgs(), 'ls-remote', `ext::${helper}`]),
    ).toThrow(/not allowed/);
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(git(['config', '--get', 'protocol.ext.allow']).trim()).toBe(
      'always',
    );
  });

  it('clones and checks out through the plugin helper without template hooks', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'test-git-clone-'));
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(root, 'global'));
    const source = path.join(root, 'source');
    await fs.mkdir(source);
    const git = (args: string[]) =>
      execFileSync('git', [...internalGitArgs(), '-C', source, ...args], {
        encoding: 'utf8',
        env: internalGitEnv(),
        stdio: 'pipe',
      });
    git(['init', '-q']);
    await fs.writeFile(path.join(source, 'file.txt'), 'content');
    git(['add', '.']);
    git([
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'initial',
    ]);
    const template = path.join(root, 'template');
    await fs.mkdir(path.join(template, 'hooks'), { recursive: true });
    await fs.writeFile(
      path.join(template, 'hooks', 'post-checkout'),
      '#!/bin/sh\nprintf ran > hook-ran\n',
      { mode: 0o755 },
    );
    git(['config', '--global', 'init.templateDir', template]);
    const target = path.join(root, 'target');
    await execPluginGit(['clone', source, target], { timeout: 5000 });
    expect(await fs.readFile(path.join(target, 'file.txt'), 'utf8')).toBe(
      'content',
    );
    await expect(fs.stat(path.join(target, 'hook-ran'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await execPluginGit(['checkout', '--detach', 'HEAD'], {
      cwd: target,
      timeout: 5000,
    });
    await expect(fs.stat(path.join(target, 'hook-ran'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

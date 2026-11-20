/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve('.github/scripts/run-release-step.sh');
const directories = [];
afterEach(() =>
  directories
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);

describe.skipIf(process.platform === 'win32')('release branch retry', () => {
  it.each([false, true])(
    'resumes a partial release only with matching contents (changed=%s)',
    (changed) => {
      const directory = mkdtempSync(join(tmpdir(), 'release-branch-retry-'));
      directories.push(directory);
      const checkout = join(directory, 'checkout');
      const remote = join(directory, 'remote.git');
      const bin = join(directory, 'bin');
      mkdirSync(checkout);
      mkdirSync(bin);
      const git = (...args) => {
        const result = spawnSync('git', args, {
          cwd: checkout,
          encoding: 'utf8',
          env: { ...process.env, HUSKY: '0', GIT_CONFIG_NOSYSTEM: '1' },
        });
        expect(result.status, result.stderr).toBe(0);
        return result.stdout.trim();
      };

      git('init');
      git('config', 'user.name', 'Release test');
      git('config', 'user.email', 'release@example.test');
      git('config', 'commit.gpgsign', 'false');
      git('config', 'core.hooksPath', '/dev/null');
      for (const file of [
        'package.json',
        'pnpm-lock.yaml',
        'packages/example/package.json',
        'packages/channels/example/package.json',
        'integrations/example/package.json',
        'integrations/example/qwen-extension.json',
      ]) {
        mkdirSync(dirname(join(checkout, file)), { recursive: true });
        writeFileSync(join(checkout, file), '{}\n');
      }
      git('add', '.');
      const trailer = 'Co-authored-by: Qwen-Coder <qwen-coder@alibabacloud.com>';
      git('commit', '-m', `Release\n\n${trailer}`);
      const original = git('rev-parse', 'HEAD');
      git('init', '--bare', remote);
      git('remote', 'add', 'origin', remote);
      git('push', 'origin', 'HEAD:refs/heads/release/v1.2.3');
      if (changed) {
        writeFileSync(join(checkout, 'package.json'), '{"changed":true}\n');
      } else {
        git('commit', '--allow-empty', '-m', `Retry\n\n${trailer}`);
      }
      writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const result = spawnSync('bash', [script, 'push-release-branch'], {
        cwd: checkout,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          HUSKY: '0',
          BRANCH_NAME: 'release/v1.2.3',
          RELEASE_TAG: 'v1.2.3',
          RELEASE_VERSION: '1.2.3',
          IS_DRY_RUN: 'false',
          CI_BOT_PAT: '',
          GITHUB_OUTPUT: join(directory, 'output'),
        },
      });
      expect(result.status, result.stderr).toBe(changed ? 1 : 0);
      expect(git('ls-remote', 'origin', 'refs/heads/release/v1.2.3')).toBe(
        `${original}\trefs/heads/release/v1.2.3`,
      );
      if (changed) {
        expect(result.stdout).toContain('different contents');
      } else {
        expect(git('rev-parse', 'HEAD')).toBe(original);
        expect(result.stdout).toContain(
          'published npm versions will be skipped',
        );
      }
    },
  );
});

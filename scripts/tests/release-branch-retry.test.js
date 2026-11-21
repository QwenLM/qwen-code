/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
      const trailer =
        'Co-authored-by: Qwen-Coder <qwen-coder@alibabacloud.com>';
      git('commit', '-m', `Release\n\n${trailer}`);
      const source = git('rev-parse', 'HEAD');
      // The remote branch tip is the version-bump commit: a direct child of
      // the release source, which the provenance check requires.
      writeFileSync(join(checkout, 'package.json'), '{"version":"1.2.3"}\n');
      git('add', '.');
      git('commit', '-m', `Bump\n\n${trailer}`);
      const original = git('rev-parse', 'HEAD');
      git('init', '--bare', remote);
      git('remote', 'add', 'origin', remote);
      git('push', 'origin', 'HEAD:refs/heads/release/v1.2.3');
      // Regenerate the bump contents as a fresh commit on the source: same
      // tree but a different hash (rerun case), or different contents.
      git('reset', '--hard', source);
      writeFileSync(
        join(checkout, 'package.json'),
        changed ? '{"version":"1.2.4"}\n' : '{"version":"1.2.3"}\n',
      );
      git('add', '.');
      git('commit', '-m', `Bump retry\n\n${trailer}`);
      // Real `gh release view` on a missing release prints the message to
      // stderr and exits 1, and the resume arm keys on that text. The stub has
      // to answer per subcommand: `gh auth setup-git` runs earlier in the step
      // and must still succeed, or the step dies before the resume logic.
      writeFileSync(
        join(bin, 'gh'),
        '#!/bin/sh\n' +
          'case "$1 $2" in\n' +
          '  "auth setup-git") exit 0 ;;\n' +
          '  "release view") echo "release not found" >&2; exit 1 ;;\n' +
          '  "run list") echo "0" ;;\n' +
          'esac\n' +
          'exit 0\n',
        { mode: 0o755 },
      );
      // Stub npm so the dist-tag guard does not hit the real registry.
      // Report the previous version (behind the release) — safe to resume.
      writeFileSync(join(bin, 'npm'), '#!/bin/sh\necho "1.2.2"\n', {
        mode: 0o755,
      });
      // Keep the real node so the semver comparator actually runs.
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
          RELEASE_SHA: source,
          NPM_TAG: 'latest',
          IS_DRY_RUN: 'false',
          CI_BOT_PAT: '',
          GITHUB_RUN_ID: '1',
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

  it('refuses to resume when npm latest has moved past the release version', () => {
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
    const source = git('rev-parse', 'HEAD');
    writeFileSync(join(checkout, 'package.json'), '{"version":"1.2.3"}\n');
    git('add', '.');
    git('commit', '-m', `Bump\n\n${trailer}`);
    git('init', '--bare', remote);
    git('remote', 'add', 'origin', remote);
    git('push', 'origin', 'HEAD:refs/heads/release/v1.2.3');
    git('reset', '--hard', source);
    writeFileSync(join(checkout, 'package.json'), '{"version":"1.2.3"}\n');
    git('add', '.');
    git('commit', '-m', `Bump retry\n\n${trailer}`);

    // Stub npm to report a newer latest; gh answers per subcommand so the
    // completed-release probe sees "not found" and the flow reaches the
    // dist-tag comparison. Real node runs the comparator.
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\necho "1.2.4"\n', {
      mode: 0o755,
    });
    writeFileSync(
      join(bin, 'gh'),
      '#!/bin/sh\n' +
        'case "$1 $2" in\n' +
        '  "auth setup-git") exit 0 ;;\n' +
        '  "release view") echo "release not found" >&2; exit 1 ;;\n' +
        '  "run list") echo "0" ;;\n' +
        'esac\n' +
        'exit 0\n',
      { mode: 0o755 },
    );
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
        RELEASE_SHA: source,
        NPM_TAG: 'latest',
        IS_DRY_RUN: 'false',
        CI_BOT_PAT: '',
        GITHUB_RUN_ID: '1',
        GITHUB_OUTPUT: join(directory, 'output'),
      },
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain('npm latest is 1.2.4');
    expect(result.stdout).toContain('regress the dist-tag');
    expect(git('ls-remote', 'origin', 'refs/heads/release/v1.2.3')).toBe(
      `${original}\trefs/heads/release/v1.2.3`,
    );
  });

  it('treats a re-run of an already-published release as a benign no-op even when the channel moved on', () => {
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
    const source = git('rev-parse', 'HEAD');
    writeFileSync(join(checkout, 'package.json'), '{"version":"1.2.3"}\n');
    git('add', '.');
    git('commit', '-m', `Bump\n\n${trailer}`);
    const original = git('rev-parse', 'HEAD');
    git('init', '--bare', remote);
    git('remote', 'add', 'origin', remote);
    git('push', 'origin', 'HEAD:refs/heads/release/v1.2.3');
    // Finalize pushed a CHANGELOG commit after the release completed, so the
    // branch tree no longer matches the regenerated bump tree.
    writeFileSync(join(checkout, 'CHANGELOG.md'), 'v1.2.3\n');
    git('add', '.');
    git('commit', '-m', `Finalize\n\n${trailer}`);
    git('push', 'origin', 'HEAD:refs/heads/release/v1.2.3');
    git('reset', '--hard', source);
    writeFileSync(join(checkout, 'package.json'), '{"version":"1.2.3"}\n');
    git('add', '.');
    git('commit', '-m', `Bump retry\n\n${trailer}`);

    // Channel already moved to 1.2.4 and the Release is published: the
    // completed-release check must win over the dist-tag refusal.
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\necho "1.2.4"\n', {
      mode: 0o755,
    });
    writeFileSync(
      join(bin, 'gh'),
      '#!/bin/sh\n' +
        'case "$1 $2" in\n' +
        '  "auth setup-git") exit 0 ;;\n' +
        '  "release view") echo "false"; exit 0 ;;\n' +
        'esac\n' +
        'exit 0\n',
      { mode: 0o755 },
    );
    const output = join(directory, 'output');
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
        RELEASE_SHA: source,
        NPM_TAG: 'latest',
        IS_DRY_RUN: 'false',
        CI_BOT_PAT: '',
        GITHUB_RUN_ID: '1',
        GITHUB_OUTPUT: output,
      },
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain('already published; nothing to resume');
    expect(readFileSync(output, 'utf8')).toContain('version_refusal=true');
  });
});

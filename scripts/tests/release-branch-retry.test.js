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
const nodeModules = resolve(dirname(script), '../../node_modules');
const directories = [];
afterEach(() =>
  directories
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);

function createFixture({
  branchVersion = '1.2.3',
  localVersion = branchVersion,
  finalize = false,
  releasePublished = false,
  npmLatest = '1.2.2',
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'release-branch-retry-'));
  directories.push(directory);
  const checkout = join(directory, 'checkout');
  const remote = join(directory, 'remote.git');
  const bin = join(directory, 'bin');
  const output = join(directory, 'output');
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
  const commit = (message) => {
    git('add', '.');
    git(
      'commit',
      '-m',
      `${message}\n\nCo-authored-by: Qwen-Coder <qwen-coder@alibabacloud.com>`,
    );
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
  commit('Release');
  const source = git('rev-parse', 'HEAD');
  writeFileSync(
    join(checkout, 'package.json'),
    `{"version":"${branchVersion}"}\n`,
  );
  commit('Bump');
  const original = git('rev-parse', 'HEAD');
  git('init', '--bare', remote);
  git('remote', 'add', 'origin', remote);
  git('push', 'origin', 'HEAD:refs/heads/release/v1.2.3');
  if (finalize) {
    // Finalize pushes a CHANGELOG commit after the release completes.
    writeFileSync(join(checkout, 'CHANGELOG.md'), `v${branchVersion}\n`);
    commit('Finalize');
    git('push', 'origin', 'HEAD:refs/heads/release/v1.2.3');
  }
  git('reset', '--hard', source);
  writeFileSync(
    join(checkout, 'package.json'),
    `{"version":"${localVersion}"}\n`,
  );
  commit('Bump retry');

  writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "${npmLatest}"\n`, {
    mode: 0o755,
  });
  writeFileSync(
    join(bin, 'gh'),
    '#!/bin/sh\n' +
      'case "$1 $2" in\n' +
      '  "auth setup-git") exit 0 ;;\n' +
      `  "release view") ${
        releasePublished
          ? 'echo "false"; exit 0'
          : 'echo "release not found" >&2; exit 1'
      } ;;\n` +
      'esac\n' +
      'exit 0\n',
    { mode: 0o755 },
  );

  return {
    git,
    original,
    output,
    run: () =>
      spawnSync('bash', [script, 'push-release-branch'], {
        cwd: checkout,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          NODE_PATH: nodeModules,
          HUSKY: '0',
          BRANCH_NAME: 'release/v1.2.3',
          RELEASE_TAG: 'v1.2.3',
          RELEASE_VERSION: '1.2.3',
          RELEASE_SHA: source,
          NPM_TAG: 'latest',
          IS_DRY_RUN: 'false',
          CI_BOT_PAT: '',
          GITHUB_OUTPUT: output,
        },
      }),
  };
}

describe.skipIf(process.platform === 'win32')('release branch retry', () => {
  it.each([false, true])(
    'resumes a partial release only with matching contents (changed=%s)',
    (changed) => {
      const fixture = createFixture({
        localVersion: changed ? '1.2.4' : '1.2.3',
      });
      const result = fixture.run();
      expect(result.status, result.stderr).toBe(changed ? 1 : 0);
      expect(
        fixture.git('ls-remote', 'origin', 'refs/heads/release/v1.2.3'),
      ).toBe(`${fixture.original}\trefs/heads/release/v1.2.3`);
      if (changed) {
        expect(result.stdout).toContain('different contents');
      } else {
        expect(fixture.git('rev-parse', 'HEAD')).toBe(fixture.original);
        expect(result.stdout).toContain(
          'published npm versions will be skipped',
        );
      }
    },
  );

  it('refuses to resume when npm latest has moved past the release version', () => {
    const fixture = createFixture({ npmLatest: '1.2.4' });
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain('npm latest is 1.2.4');
    expect(result.stdout).toContain('regress the dist-tag');
    expect(
      fixture.git('ls-remote', 'origin', 'refs/heads/release/v1.2.3'),
    ).toBe(`${fixture.original}\trefs/heads/release/v1.2.3`);
  });

  it('treats a re-run of an already-published release as a benign no-op even when the channel moved on', () => {
    const fixture = createFixture({
      finalize: true,
      releasePublished: true,
      npmLatest: '1.2.4',
    });
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain('already published; nothing to resume');
    expect(readFileSync(fixture.output, 'utf8')).toContain(
      'version_refusal=true',
    );
  });
});

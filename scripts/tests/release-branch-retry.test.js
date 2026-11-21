/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
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

function createFixture({
  branchVersion = '1.2.3',
  localVersion = branchVersion,
  finalize = false,
  releasePublished = false,
  channelStatus = 0,
  tipKind = 'bump',
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'release-branch-retry-'));
  directories.push(directory);
  const checkout = join(directory, 'checkout');
  const remote = join(directory, 'remote.git');
  const bin = join(directory, 'bin');
  const output = join(directory, 'output');
  const workflowScripts = join(checkout, '.release-workflow/scripts');
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
  let original = source;
  if (tipKind !== 'source') {
    writeFileSync(
      join(checkout, 'package.json'),
      `{"version":"${branchVersion}"}\n`,
    );
    commit('Bump');
    original = git('rev-parse', 'HEAD');
  }
  git('init', '--bare', remote);
  git('remote', 'add', 'origin', remote);
  git('push', 'origin', `${original}:refs/heads/release/v1.2.3`);
  if (tipKind === 'merge') {
    // A same-tree merge whose first parent is the release source must not
    // pass the parentage check just because rev-parse HEAD^ matches it.
    git('checkout', '--detach', source);
    git('merge', '--no-ff', '-m', 'Merge same tree', original);
    git('push', 'origin', 'HEAD:refs/heads/release/v1.2.3');
  }
  if (finalize) {
    // Finalize pushes a CHANGELOG commit after the release completes.
    git(
      'checkout',
      '--detach',
      tipKind === 'merge' ? git('rev-parse', 'HEAD') : original,
    );
    writeFileSync(join(checkout, 'CHANGELOG.md'), `v${branchVersion}\n`);
    commit('Finalize');
    git('push', 'origin', 'HEAD:refs/heads/release/v1.2.3');
  }
  git('checkout', '--detach', source);
  if (tipKind !== 'source') {
    writeFileSync(
      join(checkout, 'package.json'),
      `{"version":"${localVersion}"}\n`,
    );
    commit('Bump retry');
  }
  // The resume guard runs from the workflow-pinned checkout beside the
  // release tree, so the stub must stay untracked: a committed copy would
  // change HEAD's tree and diverge from the pushed branch.
  mkdirSync(workflowScripts, { recursive: true });
  writeFileSync(
    join(workflowScripts, 'assert-release-version.mjs'),
    `process.exit(${channelStatus});\n`,
  );
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
    source,
    output,
    run: () =>
      spawnSync('bash', [script, 'push-release-branch'], {
        cwd: checkout,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          HUSKY: '0',
          BRANCH_NAME: 'release/v1.2.3',
          RELEASE_TAG: 'v1.2.3',
          RELEASE_VERSION: branchVersion,
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
    const fixture = createFixture({ channelStatus: 1 });
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(1);
    expect(readFileSync(fixture.output, 'utf8')).toContain(
      'version_refusal=true',
    );
    expect(
      fixture.git('ls-remote', 'origin', 'refs/heads/release/v1.2.3'),
    ).toBe(`${fixture.original}\trefs/heads/release/v1.2.3`);
  });

  it('treats a re-run of an already-published release as a benign no-op even when the channel moved on', () => {
    const fixture = createFixture({
      finalize: true,
      releasePublished: true,
      channelStatus: 1,
    });
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain('already published; nothing to resume');
    expect(readFileSync(fixture.output, 'utf8')).toContain(
      'version_refusal=true',
    );
  });

  it('resumes when the source commit itself is the release tip (no version bump)', () => {
    const fixture = createFixture({ tipKind: 'source' });
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(0);
    expect(fixture.git('rev-parse', 'HEAD')).toBe(fixture.source);
    expect(readFileSync(fixture.output, 'utf8')).toContain(
      'reused_commit=true',
    );
  });

  it('refuses a same-tree merge whose first parent is the release source', () => {
    const fixture = createFixture({ tipKind: 'merge' });
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain('not the release source');
    expect(result.stdout).toContain('Refusing to resume');
  });

  it('refuses to resume when the remote tag points at a different commit', () => {
    const fixture = createFixture();
    fixture.git('push', 'origin', `${fixture.source}:refs/tags/v1.2.3`);
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain('Remote tag v1.2.3 points at');
    expect(result.stdout).toContain('Refusing to resume');
  });

  it('resumes when the remote tag already points at the release commit', () => {
    const fixture = createFixture();
    fixture.git('push', 'origin', `${fixture.original}:refs/tags/v1.2.3`);
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(0);
    expect(fixture.git('rev-parse', 'HEAD')).toBe(fixture.original);
  });

  it('fails closed without version_refusal when the channel probe cannot be confirmed', () => {
    const fixture = createFixture({ channelStatus: 2 });
    const result = fixture.run();
    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout).toContain('Resume channel probe failed');
    // A probe failure must not mark version_refusal: the workflow then
    // reports a real failure instead of silently swallowing the run.
    expect(existsSync(fixture.output)).toBe(false);
    expect(fixture.git('rev-parse', 'HEAD')).not.toBe(fixture.original);
  }, 70000);
});
